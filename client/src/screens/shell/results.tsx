// Post-match building blocks: ending copy per perspective, the route replay, the timeline strip and stats.
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { GameEventKind, MatchResult, VisibleEvent } from '@fnab/shared';
import { DEFAULT_CONFIG } from '@fnab/shared';
import { MapPanel } from '../../map/MapPanel';
import { approachLabel, hqById, nodeName } from '../../lib/data';
import { mmss } from '../../lib/format';
import { Stat } from '../../ui/kit';

export type Perspective = 'monster' | 'defenders' | 'spectator';

export interface EndingCopy {
  verdict: 'Victory' | 'Defeat' | 'Night over';
  title: string;
  line: string;
  mood: 'dawn' | 'contained' | 'breached' | 'devoured' | 'forfeit' | 'caged' | 'burned';
}

function captureNode(r: MatchResult): string | null {
  const held = [...r.timeline].reverse().find((e) => (e.kind === 'captured' || e.kind === 'trapTriggered') && e.nodeId);
  return held?.nodeId ?? r.monsterPath.at(-1)?.nodeId ?? null;
}

export function endingCopy(r: MatchResult, p: Perspective): EndingCopy {
  const hq = hqById(r.hqId)?.name ?? 'headquarters';
  const door = r.approachId
    ? (hqById(r.hqId)?.approaches.find((a) => a.id === r.approachId)?.door ?? approachLabel(r.hqId, r.approachId))
    : 'a door';
  const at = mmss(r.endedAtT);
  const nodeId = captureNode(r);
  const at_ = nodeId ? ` at ${nodeName(nodeId)}` : '';
  const won = p !== 'spectator' && p === r.winner;
  const verdict: EndingCopy['verdict'] = p === 'spectator' ? 'Night over' : won ? 'Victory' : 'Defeat';
  const monsterSide = p === 'monster';
  switch (r.reason) {
    case 'breach':
      return monsterSide
        ? { verdict, title: 'Inside', line: `You came through the ${door} at ${at}. ${hq} has gone dark.`, mood: 'devoured' }
        : {
            verdict,
            title: 'Breached',
            line: `It came through the ${door} at ${at}. The control room went quiet after that.`,
            mood: 'breached',
          };
    case 'capture':
      return monsterSide
        ? { verdict, title: 'Caged', line: `They held you${at_} until the locks closed. The cameras watch you now.`, mood: 'caged' }
        : {
            verdict,
            title: 'Contained',
            line: `Trapped${at_} and held for ${Math.round(DEFAULT_CONFIG.containment.captureMs / 1000)} seconds. It isn't going anywhere.`,
            mood: 'contained',
          };
    case 'timer':
      return monsterSide
        ? {
            verdict,
            title: 'Daylight',
            line: `The sun came up before you reached ${hq}. You fade into the morning traffic, for now.`,
            mood: 'burned',
          }
        : { verdict, title: 'Dawn', line: `${hq} held through the night. Whatever it was went back into the dark.`, mood: 'dawn' };
    case 'forfeit':
    default: {
      // Two forfeits: a team left (Leave / Abort), or a team's signal never came back within the reconnect grace.
      const signal = /reconnect|signal|grace/i.test(r.reasonText ?? '');
      if (r.winner === 'defenders') {
        if (monsterSide)
          return signal
            ? {
                verdict,
                title: 'Signal lost',
                line: 'Your connection dropped and did not come back in time. The defenders keep the night.',
                mood: 'forfeit',
              }
            : { verdict, title: 'Line dropped', line: 'You left the network. The defenders keep the night by default.', mood: 'forfeit' };
        return signal
          ? {
              verdict,
              title: 'Signal lost',
              line: `The entity's signal never came back. ${hq} holds the night by default.`,
              mood: 'forfeit',
            }
          : {
              verdict,
              title: 'Line dropped',
              line: 'The monster left the network. The defenders hold the night by default.',
              mood: 'forfeit',
            };
      }
      if (monsterSide)
        return signal
          ? {
              verdict,
              title: 'Dead air',
              line: 'Every screen in the control room went dark and stayed dark. The night is yours by default.',
              mood: 'forfeit',
            }
          : { verdict, title: 'Abandoned', line: `The defenders walked out of ${hq}. The night is yours by default.`, mood: 'forfeit' };
      return signal
        ? {
            verdict,
            title: 'Signal lost',
            line: 'The control room lost its link and no one got back in time. The monster takes the night by default.',
            mood: 'forfeit',
          }
        : {
            verdict,
            title: 'Line dropped',
            line: 'The defenders left the control room. The night belongs to the monster.',
            mood: 'forfeit',
          };
    }
  }
}

// ───────────────────────────── timeline ─────────────────────────────

const KEY_KINDS = new Set<GameEventKind>([
  'phase',
  'spawn',
  'sighting',
  'decoyExposed',
  'trapTriggered',
  'containmentStart',
  'containmentBroken',
  'captured',
  'breachStart',
  'breached',
  'sabotage',
  'powerOut',
  'doorJammed',
  'freed',
  'timer',
  'forfeit',
  'connectionLost',
  'connectionRestored',
]);

export function isKeyEvent(e: VisibleEvent): boolean {
  return KEY_KINDS.has(e.kind) || e.text.includes('[DECOY]');
}

function eventColor(e: VisibleEvent): string {
  if (e.text.includes('[DECOY]')) return '#e36b74';
  if (e.kind === 'sighting') return '#d8cfbf';
  if (e.kind === 'phase') return '#8b949e';
  return { alert: '#ff6b75', warn: '#e0b04f', good: '#3ec47a', info: '#3bc6d6' }[e.severity];
}

const PHASE_NAMES: Record<string, string> = {
  preparation: 'Prep',
  infiltration: 'Infiltration',
  escalation: 'Escalation',
  final: 'Final assault',
};

/** Horizontal night strip: phase bands + event markers, click to scrub. */
export function TimelineStrip({ result, cursorT, onSeek }: { result: MatchResult; cursorT: number; onSeek: (t: number) => void }) {
  const end = Math.max(1, result.endedAtT);
  const ref = useRef<HTMLDivElement>(null);
  const phases = useMemo(() => {
    const prepEnd = DEFAULT_CONFIG.match.prepMs;
    const marks = result.timeline.filter((e) => e.kind === 'phase');
    const out: Array<{ name: string; from: number; to: number }> = [{ name: 'preparation', from: 0, to: Math.min(end, prepEnd) }];
    const order = ['infiltration', 'escalation', 'final'];
    for (const m of marks) {
      const id = order.find((o) => m.text.toLowerCase().includes(o === 'final' ? 'final' : o));
      if (!id) continue;
      out.at(-1)!.to = m.t;
      out.push({ name: id, from: m.t, to: end });
    }
    return out.filter((p) => p.to > p.from);
  }, [result, end]);
  const key = result.timeline.filter(isKeyEvent).filter((e) => e.kind !== 'phase');
  const seekFromX = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onSeek(Math.max(0, Math.min(end, ((clientX - r.left) / r.width) * end)));
  };
  return (
    <div className="select-none">
      <div
        ref={ref}
        className="relative h-10 cursor-pointer border border-edge bg-ink"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          seekFromX(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && seekFromX(e.clientX)}
        role="slider"
        aria-label="Match time"
        aria-valuemin={0}
        aria-valuemax={end}
        aria-valuenow={Math.round(cursorT)}
        aria-valuetext={mmss(cursorT)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(Math.min(end, cursorT + 5000));
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, cursorT - 5000));
        }}
        data-testid="timeline-strip"
      >
        {phases.map((p, i) => (
          <div
            key={i}
            className={clsx('absolute inset-y-0 border-r border-edge/80', i % 2 ? 'bg-white/[0.025]' : 'bg-transparent')}
            style={{ left: `${(p.from / end) * 100}%`, width: `${((p.to - p.from) / end) * 100}%` }}
          >
            <span className="absolute left-1.5 top-0.5 truncate font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
              {PHASE_NAMES[p.name]}
            </span>
          </div>
        ))}
        {key.map((e) => (
          <span
            key={e.id}
            title={`${mmss(e.t)}  ${e.text}`}
            className="absolute bottom-1 w-[3px] -translate-x-1/2"
            style={{
              left: `${(e.t / end) * 100}%`,
              height: e.kind === 'breached' || e.kind === 'captured' || e.kind === 'trapTriggered' ? 18 : e.kind === 'sighting' ? 9 : 13,
              background: eventColor(e),
            }}
          />
        ))}
        <div
          className="pointer-events-none absolute inset-y-[-3px] w-px bg-bright shadow-[0_0_8px_rgba(255,255,255,0.6)]"
          style={{ left: `${(cursorT / end) * 100}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-dim">
        <span>0:00</span>
        <span className="text-text">{mmss(cursorT)}</span>
        <span>{mmss(end)}</span>
      </div>
    </div>
  );
}

export function TimelineList({
  result,
  cursorT,
  onSeek,
  all,
}: {
  result: MatchResult;
  cursorT: number;
  onSeek: (t: number) => void;
  all: boolean;
}) {
  const list = all ? result.timeline : result.timeline.filter(isKeyEvent);
  const activeRef = useRef<HTMLLIElement>(null);
  const activeId = [...list].reverse().find((e) => e.t <= cursorT)?.id;
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  return (
    <>
    {result.players && <p className="border-b border-edge px-3 py-2 text-[11px] text-mute" data-testid="result-players">
      {result.players.map(p => p.name).join(' · ')}
    </p>}
    <ol className="font-mono text-[11px]" data-testid="timeline">
      {list.map((e) => {
        const decoy = e.text.includes('[DECOY]');
        const future = e.t > cursorT;
        return (
          <li
            key={e.id}
            ref={e.id === activeId ? activeRef : undefined}
            className={clsx(
              'flex cursor-pointer gap-2.5 border-b border-edge/50 px-3 py-1.5 transition-colors hover:bg-white/[0.03]',
              e.id === activeId && 'bg-white/[0.05]',
              future && 'opacity-45',
            )}
            onClick={() => onSeek(e.t)}
          >
            <span className="w-9 shrink-0 tabular-nums text-dim">{mmss(e.t)}</span>
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: eventColor(e) }} />
            <span
              className={clsx(
                'min-w-0',
                decoy
                  ? 'text-[#e36b74]'
                  : e.severity === 'alert'
                    ? 'text-[#ff8a93]'
                    : e.severity === 'warn'
                      ? 'text-[#f3d28d]'
                      : e.severity === 'good'
                        ? 'text-[#9fe8bf]'
                        : 'text-text',
              )}
            >
              {e.by && <span className="text-dim">{result.players?.find(p => p.id === e.by)?.name ?? 'Operator'} · </span>}{e.text}
            </span>
          </li>
        );
      })}
      {!list.length && <li className="px-3 py-2 text-dim">Nothing happened. Somehow.</li>}
    </ol>
    </>
  );
}

// ───────────────────────────── route replay ─────────────────────────────

export function useReplayCursor(endT: number, autoplayMs = 12_000) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [lastEnd, setLastEnd] = useState(endT);
  if (lastEnd !== endT) {
    // a new result: restart the replay
    setLastEnd(endT);
    setT(0);
    setPlaying(true);
  }
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const rate = endT / autoplayMs;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setT((cur) => {
        const next = Math.min(endT, cur + dt * rate);
        if (next >= endT) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, endT, autoplayMs]);
  return {
    t: Math.min(t, endT),
    playing,
    seek: (v: number) => {
      setPlaying(false);
      setT(v);
    },
    toggle: () => {
      if (!playing && t >= endT) setT(0);
      setPlaying((p) => !p);
    },
  };
}

export function RouteReplay({ result, t, perspective }: { result: MatchResult; t: number; perspective: Perspective }) {
  const path = result.monsterPath.filter((p) => p.t <= t).map((p) => p.nodeId);
  const here = path.at(-1) ?? null;
  const sightings = result.timeline
    .filter((e) => e.kind === 'sighting' && e.nodeId && e.t <= t)
    .map((e) => ({
      id: e.id,
      nodeId: e.nodeId!,
      age: Math.min(1, (t - e.t) / 60_000),
      confidence: 0.7,
      flagged: e.text.includes('[DECOY]'),
      source: 'camera',
    }));
  const ended = t >= result.endedAtT - 1;
  return (
    <div className="relative h-full w-full">
      <MapPanel
        hqId={result.hqId}
        path={path}
        sightings={sightings}
        breachApproachId={ended && result.reason === 'breach' ? result.approachId : null}
        held={ended && result.reason === 'capture' ? here : null}
        monster={here ? { nodeId: here, moving: null } : null}
        // The viewer's own console palette: the revealed route is drawn on the defenders' map for them.
        theme={perspective === 'monster' ? 'monster' : 'defender'}
        attackPaths={false}
        noLegend
        // The legend sits top-left (open ocean on the tactical map); keep the fit clear of it using the spare width.
        inset={{ left: 236 }}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex w-[220px] flex-col gap-1 border border-edge bg-black/70 px-2.5 py-1.5 text-[11px] text-mute backdrop-blur">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 bg-[#e04a62]" /> where it actually went
        </span>
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full border border-bone" />{' '}
          {perspective === 'monster' ? 'where they saw you' : 'where the cameras saw it'}
        </span>
        <span className="text-dim">
          {path.length ? `Now: ${nodeName(here)}` : 'Not on the map yet'} · {sightings.length} sighting{sightings.length === 1 ? '' : 's'}{' '}
          so far
        </span>
      </div>
    </div>
  );
}

// ───────────────────────────── stats ─────────────────────────────

export function StatsBoard({ result }: { result: MatchResult }) {
  const s = result.stats;
  const real = Math.max(0, s.sightings - s.falseSightings);
  const groups: Array<{ name: string; tone: 'cyan' | 'bone'; items: Array<{ label: string; value: string | number; sub?: string }> }> = [
    {
      name: 'Surveillance',
      tone: 'cyan',
      items: [
        { label: 'Camera sightings', value: s.sightings, sub: `${real} real · ${s.falseSightings} decoy` },
        { label: 'Decoys exposed', value: `${s.decoysExposed}/${s.falseSightings}`, sub: 'caught by a scan / planted' },
        { label: 'Sensor pings', value: s.sensorPings },
        { label: 'Scans', value: s.scans },
      ],
    },
    {
      name: 'Defense',
      tone: 'cyan',
      items: [
        { label: 'Traps sprung', value: `${s.trapsTriggered}/${s.trapsArmed}`, sub: 'sprung / armed' },
        { label: 'Containment attempts', value: s.containmentAttempts },
        {
          label: 'Power spent',
          value: Math.round(s.powerSpent),
          sub: s.powerOutages ? `${s.powerOutages} blackout${s.powerOutages > 1 ? 's' : ''}` : 'no blackouts',
        },
        {
          label: 'Doors sealed',
          value: `${Math.round(s.doorCloseSeconds)} s`,
          sub: `${s.repairs} camera repair${s.repairs === 1 ? '' : 's'}`,
        },
      ],
    },
    {
      name: 'The monster',
      tone: 'bone',
      items: [
        { label: 'Distance travelled', value: `${Math.round(s.monsterDistanceKm)} km` },
        { label: 'Cameras passed', value: s.monsterNodesVisited },
        { label: 'Commands issued', value: s.commandsIssued },
        { label: 'Sabotages', value: s.sabotages, sub: `${s.cameraFailures} random failure${s.cameraFailures === 1 ? '' : 's'}` },
      ],
    },
  ];
  return (
    <div className="flex flex-col gap-4 p-3" data-testid="stats">
      {groups.map((g) => (
        <section key={g.name}>
          <h3 className={clsx('mb-2 flex items-center gap-2 text-[12px] font-semibold', g.tone === 'bone' ? 'text-bone' : 'text-cyan')}>
            <span className={clsx('h-1.5 w-1.5', g.tone === 'bone' ? 'bg-blood-hi' : 'bg-cyan')} />
            {g.name}
          </h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {g.items.map((it) => (
              <Stat key={it.label} label={it.label} value={it.value} sub={it.sub} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
