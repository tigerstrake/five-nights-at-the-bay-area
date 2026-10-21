import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { MatchResult, RoomView } from '@fnab/shared';
import { BreachSequence, ContainmentSequence, BREACH_DURATION_MS, CONTAINMENT_DURATION_MS } from '../fx';
import { lobby, leaveRoom } from '../net/socket';
import { Button, Panel, Segmented } from '../ui/kit';
import { SettingsMenu } from '../ui/chrome';
import { useImageOk, useUiAssets } from '../ui/assets';
import { hqById } from '../lib/data';
import { mmss } from '../lib/format';
import { BrandMark } from './shell/Brand';
import { endingCopy, RouteReplay, StatsBoard, TimelineList, TimelineStrip, useReplayCursor, type EndingCopy, type Perspective } from './shell/results';

const MOOD: Record<
  EndingCopy['mood'],
  { title: string; glow: string; grade: string }
> = {
  // defenders survived: cold control room, first warm light at the bottom edge
  dawn: {
    title: 'text-[#f4efe6] [text-shadow:0_0_50px_rgba(255,190,120,0.35)]',
    glow: 'linear-gradient(0deg, rgba(150,85,35,0.6) 0%, rgba(90,55,35,0.28) 28%, transparent 60%), radial-gradient(ellipse at 70% 125%, rgba(255,170,90,0.45) 0%, transparent 60%)',
    grade: 'grayscale(0.5) brightness(0.55)',
  },
  contained: {
    title: 'text-[#d7fbe8] [text-shadow:0_0_50px_rgba(62,196,122,0.45)]',
    glow: 'radial-gradient(ellipse at 50% 60%, rgba(62,196,122,0.22) 0%, transparent 60%)',
    grade: 'grayscale(0.7) brightness(0.45) sepia(0.2) hue-rotate(90deg)',
  },
  breached: {
    title: 'text-[#ffd9dc] [text-shadow:0_0_60px_rgba(200,50,58,0.65)]',
    glow: 'radial-gradient(ellipse at 50% 20%, rgba(200,50,58,0.35) 0%, transparent 60%)',
    grade: 'brightness(0.8) contrast(1.1)',
  },
  devoured: {
    title: 'text-bone [text-shadow:0_0_60px_rgba(179,32,47,0.7)]',
    glow: 'radial-gradient(ellipse at 50% 30%, rgba(125,20,32,0.45) 0%, transparent 65%)',
    grade: 'brightness(0.85) sepia(0.35) contrast(1.15)',
  },
  // monster caught: cold steel, bars across the picture
  caged: {
    title: 'text-[#cfd6dc] [text-shadow:0_0_40px_rgba(140,170,190,0.35)]',
    glow: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.55) 0 5px, transparent 5px 72px), radial-gradient(ellipse at 40% 0%, rgba(150,180,200,0.22) 0%, transparent 60%)',
    grade: 'grayscale(1) brightness(0.45) contrast(1.2)',
  },
  // monster out of time: the morning overexposes the feed
  burned: {
    title: 'text-[#fff4e4] [text-shadow:0_0_60px_rgba(255,200,140,0.6)]',
    glow: 'linear-gradient(0deg, rgba(255,214,170,0.42) 0%, rgba(255,170,110,0.16) 35%, transparent 70%)',
    grade: 'grayscale(0.6) brightness(0.9) contrast(0.8) sepia(0.3)',
  },
  forfeit: {
    title: 'text-bright',
    glow: 'radial-gradient(ellipse at 50% 50%, rgba(139,148,158,0.15) 0%, transparent 60%)',
    grade: 'grayscale(1) brightness(0.4)',
  },
};

export function ResultsScreen({ room, result }: { room: RoomView; result: MatchResult }) {
  const hasCinematic = result.reason === 'breach' || result.reason === 'capture';
  const [cinematic, setCinematic] = useState(hasCinematic);
  const [allEvents, setAllEvents] = useState(false);
  const assets = useUiAssets();
  const me = room.players.find((p) => p.id === room.youId);
  const perspective: Perspective = me?.role === 'monster' ? 'monster' : me?.role === 'defender' ? 'defenders' : 'spectator';
  const copy = endingCopy(result, perspective);
  const mood = MOOD[copy.mood];
  const hq = hqById(result.hqId);
  const host = room.players.find((p) => p.isHost);
  const replay = useReplayCursor(result.endedAtT);

  // Art: the monster's moment uses the defeat plate; a defender win uses victory art when provided.
  const monsterWon = result.winner === 'monster';
  const artSrc = monsterWon ? (assets.defeat ?? assets.keyart) : (assets.victory ?? assets.keyart);
  const artOk = useImageOk(artSrc);
  const usingVictoryArt = !monsterWon && !!assets.victory && artSrc === assets.victory;

  useEffect(() => {
    if (!cinematic) return;
    // onDone moves on; this is only a safety net.
    const id = setTimeout(() => setCinematic(false), Math.max(BREACH_DURATION_MS, CONTAINMENT_DURATION_MS) + 2500);
    return () => clearTimeout(id);
  }, [cinematic]);

  if (cinematic)
    return (
      <div className="fixed inset-0 z-30" data-testid="breach-sequence">
        {result.reason === 'breach' ? (
          <BreachSequence hqName={hq?.name ?? 'HQ'} onDone={() => setCinematic(false)} />
        ) : (
          <ContainmentSequence hqName={hq?.name ?? 'HQ'} onDone={() => setCinematic(false)} />
        )}
        <button
          style={{ zIndex: 2147483647 }}
          className="fixed bottom-5 right-5 border border-edge bg-black/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-mute hover:text-text"
          onClick={() => setCinematic(false)}
        >
          Skip ▸
        </button>
      </div>
    );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-void" data-testid="results-screen" data-mood={copy.mood}>
      {/* Hero */}
      <section className="relative shrink-0 overflow-hidden border-b border-edge pb-6" style={{ minHeight: 'clamp(250px, 36vh, 340px)' }}>
        {artOk && (
          <img
            src={artSrc}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: usingVictoryArt ? 'brightness(0.7)' : mood.grade, objectPosition: monsterWon ? 'center 30%' : 'right center' }}
          />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-void via-void/70 to-void/5" />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-void/80 to-transparent" />
        <div aria-hidden className="absolute inset-0" style={{ background: mood.glow }} />
        <div aria-hidden className="fnab-noise absolute inset-0 opacity-[0.06]" />

        <header className="relative z-10 flex items-center justify-between px-6 py-3">
          <BrandMark />
          <SettingsMenu />
        </header>
        <div className="relative z-10 flex flex-col px-6 lg:pl-[5vw]">
          <div className="flex items-center gap-3 motion-safe:animate-rise">
            <span
              className={clsx(
                'border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.24em]',
                copy.verdict === 'Victory' && (perspective === 'monster' ? 'border-bone/60 text-bone' : 'border-ok/60 text-ok'),
                copy.verdict === 'Defeat' && 'border-alert/60 text-[#ff8a93]',
                copy.verdict === 'Night over' && 'border-edge-hi text-mute',
              )}
              data-testid="verdict"
            >
              {copy.verdict}
            </span>
            <span className="text-[13px] text-mute" data-testid="winner">
              {monsterWon ? 'The Monster Wins' : 'The Defenders Win'}
            </span>
            <span className="font-mono text-[11px] text-dim">
              {hq?.name} · {mmss(result.endedAtT)}
            </span>
          </div>
          <h1
            className={clsx('mt-2 font-display text-[clamp(56px,min(9vw,13vh),128px)] font-black leading-[0.86] tracking-[-0.02em] motion-safe:animate-rise', mood.title)}
            data-testid="ending-title"
          >
            {copy.title}
          </h1>
          <p className="mt-3 max-w-[620px] text-[15px] leading-snug text-text/90 motion-safe:animate-rise">{copy.line}</p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {me?.isHost ? (
              <Button tone="cyan" size="lg" onClick={() => void lobby.restart()} data-testid="play-again">
                Play again
              </Button>
            ) : (
              <span className="border border-edge bg-black/40 px-3 py-2 text-[12px] text-mute" data-testid="waiting-host">
                Waiting for {host?.name ?? 'the host'} to start the next night
              </span>
            )}
            {hasCinematic && (
              <Button size="lg" tone="ghost" onClick={() => setCinematic(true)}>
                {result.reason === 'breach' ? 'Replay breach' : 'Replay capture'}
              </Button>
            )}
            <Button size="lg" tone="ghost" onClick={leaveRoom} data-testid="leave">
              Leave room
            </Button>
          </div>
        </div>
      </section>

      {/* Debrief */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_300px] lg:overflow-hidden">
        <Panel
          title={perspective === 'monster' ? 'Your route, and what they saw' : 'The monster’s route, revealed'}
          right={
            <button
              onClick={replay.toggle}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute hover:text-text"
              data-testid="replay-toggle"
            >
              {replay.playing ? 'Pause' : replay.t >= result.endedAtT ? 'Replay' : 'Play'}
            </button>
          }
          className="min-h-[360px]"
          bodyClass="flex flex-col"
        >
          <div className="min-h-0 flex-1">
            <RouteReplay result={result} t={replay.t} perspective={perspective} />
          </div>
          <div className="border-t border-edge p-2.5">
            <TimelineStrip result={result} cursorT={replay.t} onSeek={replay.seek} />
          </div>
        </Panel>
        <Panel
          title="Timeline · both sides"
          right={
            <Segmented
              options={[
                { value: 'key', label: 'Key moments' },
                { value: 'all', label: 'Everything' },
              ]}
              value={allEvents ? 'all' : 'key'}
              onChange={(v) => setAllEvents(v === 'all')}
              className="w-52 [&>button]:py-0.5 [&>button]:text-[10px]"
            />
          }
          className="min-h-[300px]"
          bodyClass="overflow-auto"
        >
          <TimelineList result={result} cursorT={replay.t} onSeek={replay.seek} all={allEvents} />
        </Panel>
        <Panel title="Night report" bodyClass="overflow-auto">
          <StatsBoard result={result} />
        </Panel>
      </div>
    </div>
  );
}
